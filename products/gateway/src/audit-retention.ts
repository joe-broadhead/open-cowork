export type AuditComplianceLedgerStatus = 'local_append_only_foundation_not_certified' | 'design_only_not_implemented'
export type AuditEventClass =
  | 'user_action'
  | 'agent_action'
  | 'channel_event'
  | 'mcp_tool'
  | 'scheduler_transition'
  | 'storage_admin'
  | 'config_admin'
  | 'security_decision'
  | 'human_gate_decision'
  | 'evidence_export'
  | 'incident_response'
  | 'extension_change'
  | 'secret_reference'

export type AuditMode = 'local_beta_redacted_evidence' | 'self_hosted_team_design' | 'hosted_compliance_unsupported'
export type AuditActorKind =
  | 'local_operator'
  | 'user'
  | 'service_account'
  | 'channel_identity'
  | 'agent'
  | 'worker'
  | 'connector'
  | 'mcp_client'
  | 'gateway_system'

export type AuditResourceKind =
  | 'organization'
  | 'workspace'
  | 'project'
  | 'session'
  | 'roadmap'
  | 'task'
  | 'run'
  | 'channel_binding'
  | 'channel_message'
  | 'human_gate'
  | 'config'
  | 'storage'
  | 'evidence_export'
  | 'incident_bundle'
  | 'opencode_asset'
  | 'worker_pool'
  | 'remote_environment'
  | 'extension_package'
  | 'secret_reference'
  | 'audit_log'

export type AuditRetentionClass =
  | 'ephemeral_operational'
  | 'local_beta_work_history'
  | 'security_audit'
  | 'incident_evidence'
  | 'team_compliance_ledger'
  | 'secret_metadata'

export interface AuditEventClassDefinition {
  class: AuditEventClass
  actorKinds: AuditActorKind[]
  resourceKinds: AuditResourceKind[]
  requiredFields: string[]
  currentSurface: string
  retentionClass: AuditRetentionClass
  redaction: string
}

export interface AuditRetentionPolicy {
  class: AuditRetentionClass
  localBeta: string
  selfHostedTeam: string
  hostedFuture: string
  deletionBehavior: string
  evidenceExportBehavior: string
}

export interface AuditCurrentSurfaceMapping {
  surface: string
  eventTypes: string[]
  supportedNow: boolean
  gap: string
}

export interface IncidentEvidenceContract {
  manifestFields: string[]
  bundleContents: string[]
  redactionRules: string[]
  forbiddenContents: string[]
}

export interface AuditEventShape {
  eventId: string
  class: AuditEventClass
  actor: { kind: AuditActorKind; idRef: string }
  resource: { kind: AuditResourceKind; idRef: string }
  action: string
  result: 'ok' | 'denied' | 'error'
  occurredAt: string
  traceId: string
  retentionClass: AuditRetentionClass
  redacted: boolean
  evidenceRefs: string[]
}

export interface AuditEventShapeViolation {
  code: string
  field?: string
  message: string
}

export interface AuditRetentionReport {
  mode: AuditMode
  releaseStatus: 'supported_public_local_beta'
  complianceLedgerStatus: AuditComplianceLedgerStatus
  hostedStatus: 'unsupported'
  localEvidenceStatus: 'redacted_evidence_and_incident_bundles_supported'
  rawTranscriptPolicy: 'never_in_compliance_audit_or_shareable_evidence'
  totals: {
    eventClasses: number
    actorKinds: number
    resourceKinds: number
    retentionClasses: number
    currentSurfaces: number
    currentSupportedSurfaces: number
    requiredShapeFields: number
  }
  eventClasses: AuditEventClassDefinition[]
  retentionPolicies: AuditRetentionPolicy[]
  currentSurfaces: AuditCurrentSurfaceMapping[]
  incidentEvidence: IncidentEvidenceContract
  ledger: {
    schemaVersion: number
    storage: 'gateway.db:audit_ledger'
    appendOnly: true
    hashChained: true
    localOnly: true
    certification: 'not_certified_compliance_storage'
    sourceEventFamilies: string[]
  }
  caveats: string[]
}

export const AUDIT_LEDGER_SCHEMA_VERSION = 1

export const AUDIT_REQUIRED_SHAPE_FIELDS = [
  'eventId',
  'class',
  'actor.kind',
  'actor.idRef',
  'resource.kind',
  'resource.idRef',
  'action',
  'result',
  'occurredAt',
  'traceId',
  'retentionClass',
  'redacted',
  'evidenceRefs',
]

export const AUDIT_EVENT_CLASSES: AuditEventClassDefinition[] = [
  {
    class: 'user_action',
    actorKinds: ['local_operator', 'user', 'channel_identity'],
    resourceKinds: ['project', 'roadmap', 'task', 'session'],
    requiredFields: AUDIT_REQUIRED_SHAPE_FIELDS,
    currentSurface: 'task/roadmap/project workflow events and channel commands',
    retentionClass: 'local_beta_work_history',
    redaction: 'Store actor/resource refs and summaries only; private prompt text stays out of audit rows.',
  },
  {
    class: 'agent_action',
    actorKinds: ['agent'],
    resourceKinds: ['task', 'run', 'session', 'opencode_asset'],
    requiredFields: AUDIT_REQUIRED_SHAPE_FIELDS,
    currentSurface: 'run lifecycle, team assembly, promotion, and stage-result evidence',
    retentionClass: 'local_beta_work_history',
    redaction: 'Store role/profile/session refs, result status, artifact refs, and redacted summaries.',
  },
  {
    class: 'channel_event',
    actorKinds: ['channel_identity', 'connector'],
    resourceKinds: ['channel_binding', 'channel_message', 'session', 'project'],
    requiredFields: AUDIT_REQUIRED_SHAPE_FIELDS,
    currentSurface: 'channel binding, delivery, proof, and trusted-target events',
    retentionClass: 'security_audit',
    redaction: 'Provider targets are hashed/redacted; raw provider payloads and target IDs are excluded.',
  },
  {
    class: 'mcp_tool',
    actorKinds: ['mcp_client', 'agent', 'service_account'],
    resourceKinds: ['task', 'roadmap', 'config', 'storage', 'evidence_export', 'opencode_asset'],
    requiredFields: AUDIT_REQUIRED_SHAPE_FIELDS,
    currentSurface: 'Gateway MCP tool calls',
    retentionClass: 'team_compliance_ledger',
    redaction: 'Arguments must be summarized or referenced; raw local file contents and secrets are forbidden.',
  },
  {
    class: 'scheduler_transition',
    actorKinds: ['gateway_system', 'worker', 'agent'],
    resourceKinds: ['task', 'run', 'worker_pool', 'remote_environment'],
    requiredFields: AUDIT_REQUIRED_SHAPE_FIELDS,
    currentSurface: 'task.dispatch.*, task.run.*, roadmap.supervisor.*, environment.* events',
    retentionClass: 'local_beta_work_history',
    redaction: 'Lease owners, session IDs, environment IDs, and worker labels are hashed/redacted for export.',
  },
  {
    class: 'storage_admin',
    actorKinds: ['local_operator', 'service_account', 'mcp_client'],
    resourceKinds: ['storage', 'audit_log'],
    requiredFields: AUDIT_REQUIRED_SHAPE_FIELDS,
    currentSurface: 'backup, restore, recovery drill, and state export surfaces',
    retentionClass: 'security_audit',
    redaction: 'Paths outside repo/state are redacted; backup IDs and hashes are safe evidence refs.',
  },
  {
    class: 'config_admin',
    actorKinds: ['local_operator', 'service_account', 'mcp_client'],
    resourceKinds: ['config', 'secret_reference'],
    requiredFields: AUDIT_REQUIRED_SHAPE_FIELDS,
    currentSurface: 'config doctor/readiness and future config mutation audit',
    retentionClass: 'security_audit',
    redaction: 'Config key names and presence are allowed; configured secret values are never allowed.',
  },
  {
    class: 'security_decision',
    actorKinds: ['gateway_system', 'connector', 'channel_identity'],
    resourceKinds: ['channel_binding', 'session', 'task', 'run', 'evidence_export', 'config'],
    requiredFields: AUDIT_REQUIRED_SHAPE_FIELDS,
    currentSurface: 'audit.security events plus runtime capability decisions for denied inbound, exposed HTTP, sensitive operation checks, and Gateway-controlled dispatch boundaries',
    retentionClass: 'security_audit',
    redaction: 'Record deny/allow decision, capability, source class, and target hash only.',
  },
  {
    class: 'human_gate_decision',
    actorKinds: ['local_operator', 'user', 'channel_identity', 'gateway_system'],
    resourceKinds: ['human_gate', 'task', 'roadmap', 'run'],
    requiredFields: AUDIT_REQUIRED_SHAPE_FIELDS,
    currentSurface: 'human_gate.* and audit.human_decision events',
    retentionClass: 'security_audit',
    redaction: 'Decision notes must be bounded and redacted before export.',
  },
  {
    class: 'evidence_export',
    actorKinds: ['local_operator', 'user', 'service_account', 'mcp_client'],
    resourceKinds: ['evidence_export', 'incident_bundle', 'task', 'run', 'roadmap', 'project'],
    requiredFields: AUDIT_REQUIRED_SHAPE_FIELDS,
    currentSurface: 'redacted evidence bundle and incident bundle generation',
    retentionClass: 'incident_evidence',
    redaction: 'Shareable bundles are redacted by default; unredacted export requires explicit local/admin intent.',
  },
  {
    class: 'incident_response',
    actorKinds: ['local_operator', 'user', 'gateway_system'],
    resourceKinds: ['incident_bundle', 'evidence_export', 'audit_log'],
    requiredFields: AUDIT_REQUIRED_SHAPE_FIELDS,
    currentSurface: 'alerts, incident reports, incident bundles, and follow-up tasks',
    retentionClass: 'incident_evidence',
    redaction: 'Incident summaries include trace IDs and next actions, not private transcripts or raw provider data.',
  },
  {
    class: 'extension_change',
    actorKinds: ['local_operator', 'user', 'service_account', 'mcp_client'],
    resourceKinds: ['extension_package', 'opencode_asset'],
    requiredFields: AUDIT_REQUIRED_SHAPE_FIELDS,
    currentSurface: 'OpenCode asset/profile/team promotion and future extension package lifecycle',
    retentionClass: 'security_audit',
    redaction: 'Record package/profile identifiers, checksums, versions, and rollback refs; omit raw credentials.',
  },
  {
    class: 'secret_reference',
    actorKinds: ['local_operator', 'service_account', 'gateway_system', 'worker'],
    resourceKinds: ['secret_reference', 'config', 'remote_environment'],
    requiredFields: AUDIT_REQUIRED_SHAPE_FIELDS,
    currentSurface: 'secret lifecycle readiness and future scoped injection receipts',
    retentionClass: 'secret_metadata',
    redaction: 'Only reference IDs, classes, scopes, and rotation/revocation events are audit-safe.',
  },
]

export const AUDIT_RETENTION_POLICIES: AuditRetentionPolicy[] = [
  {
    class: 'ephemeral_operational',
    localBeta: 'Bounded local operational rollups may be pruned with existing state/event caps.',
    selfHostedTeam: 'Short retention such as 7-30 days, configurable per workspace.',
    hostedFuture: 'Tenant-configurable short retention with deletion and legal-hold hooks.',
    deletionBehavior: 'Delete or aggregate after expiry when not referenced by an incident bundle.',
    evidenceExportBehavior: 'Export only counts, status, and redacted refs unless selected by an incident.',
  },
  {
    class: 'local_beta_work_history',
    localBeta: 'Retained in local gateway.db and redacted evidence bundles; workflow events remain bounded by local retention.',
    selfHostedTeam: 'Append-only work ledger with retention policy per organization/project.',
    hostedFuture: 'Managed ledger retention with tenant policy, export, deletion, and legal hold.',
    deletionBehavior: 'Supersede or redact mutable summaries; keep structural receipts while policy allows.',
    evidenceExportBehavior: 'Include redacted task/run/session/trace refs and artifact hashes.',
  },
  {
    class: 'security_audit',
    localBeta: 'Best-effort local audit events and readiness/evidence redaction checks.',
    selfHostedTeam: 'Append-only security audit ledger with tamper-evident hashes and admin export.',
    hostedFuture: 'Compliance-grade immutable ledger with org retention, alerting, and access reviews.',
    deletionBehavior: 'Do not hard-delete before retention expiry; redact personal/private fields instead.',
    evidenceExportBehavior: 'Include decision, actor/resource refs, target hashes, and redacted reason codes.',
  },
  {
    class: 'incident_evidence',
    localBeta: 'Redacted local incident bundles under the Gateway state directory.',
    selfHostedTeam: 'Incident bundles have explicit owner, retention class, manifest hash, and access trail.',
    hostedFuture: 'Tenant incident case store with controlled sharing and support export workflow.',
    deletionBehavior: 'Retain until incident closure plus policy window; purge nested artifacts by manifest.',
    evidenceExportBehavior: 'Bundle manifest, SLOs, trace IDs, selected alerts, nested redacted evidence, and hashes.',
  },
  {
    class: 'team_compliance_ledger',
    localBeta: 'Local append-only audit ledger foundation records redacted normalized rows; it is not certified compliance storage.',
    selfHostedTeam: 'Append-only canonical ledger for team actions, MCP calls, worker packets, and package changes.',
    hostedFuture: 'Tenant-isolated ledger with audit-reader roles, retention policy, export, and legal hold.',
    deletionBehavior: 'No physical deletion except policy-governed purge; record tombstones/redactions.',
    evidenceExportBehavior: 'Export normalized event rows and manifest hashes, never raw payloads.',
  },
  {
    class: 'secret_metadata',
    localBeta: 'Readiness reports configured input IDs and risk codes without values.',
    selfHostedTeam: 'Vault reference lifecycle audit records rotation, revocation, injection, and access decisions.',
    hostedFuture: 'Managed vault metadata audit with scoped principal/resource grants and break-glass trail.',
    deletionBehavior: 'Keep non-secret lifecycle metadata; revoke references and purge secret material in vault.',
    evidenceExportBehavior: 'Export reference IDs, scopes, classes, and risk/remediation codes only.',
  },
]

export const AUDIT_CURRENT_SURFACES: AuditCurrentSurfaceMapping[] = [
  {
    surface: 'workflow_events',
    eventTypes: ['task.*', 'roadmap.*', 'delegation.*', 'human_gate.*', 'project.binding.*'],
    supportedNow: true,
    gap: 'Retention is local and bounded; not a team compliance ledger.',
  },
  {
    surface: 'security_audit_events',
    eventTypes: ['audit.security', 'audit.human_decision'],
    supportedNow: true,
    gap: 'Coverage is focused on existing sensitive decisions; future admin/config/storage/extension actions need normalized rows.',
  },
  {
    surface: 'redacted_evidence_export',
    eventTypes: ['evidence.export.generated'],
    supportedNow: true,
    gap: 'Generated bundles are redacted and deterministic, but export-generation itself needs first-class audit rows for team mode.',
  },
  {
    surface: 'incident_bundles',
    eventTypes: ['incident.bundle.generated'],
    supportedNow: true,
    gap: 'Local redacted bundles exist; retention ownership and access trails are future work.',
  },
  {
    surface: 'append_only_audit_ledger',
    eventTypes: ['audit.security', 'audit.human_decision', 'delegation.*', 'channel.*', 'project.binding.*', 'evidence.export.*', 'incident.*'],
    supportedNow: true,
    gap: 'Local append-only, hash-chained foundation exists; hosted immutability, legal hold, tenant access trails, and certification remain future work.',
  },
  {
    surface: 'extension_package_governance',
    eventTypes: ['extension.*', 'package.*'],
    supportedNow: false,
    gap: 'Extension package trust ledger is design-only until governance enforcement lands.',
  },
]

export const INCIDENT_EVIDENCE_CONTRACT: IncidentEvidenceContract = {
  manifestFields: [
    'schemaVersion',
    'id',
    'generatedAt',
    'status',
    'target',
    'alertId',
    'evidenceBundleId',
    'traceRootId',
    'counts',
    'slo',
    'alerts',
    'redaction',
    'manifestHash',
  ],
  bundleContents: [
    'incident manifest',
    'incident markdown summary',
    'nested redacted evidence manifest',
    'trace correlation index',
    'SLO results',
    'selected alert summaries',
    'artifact hashes or omitted reasons',
    'redaction rules applied',
  ],
  redactionRules: [
    'provider targets hashed/redacted',
    'session IDs redacted or hashed',
    'absolute private paths redacted',
    'configured secrets and token-like strings redacted',
    'private transcript/message bodies omitted or redacted',
    'webhook URLs and signatures redacted',
  ],
  forbiddenContents: [
    'raw provider payloads',
    'raw channel targets',
    'bearer tokens',
    'model/provider API keys',
    'MCP credentials',
    'webhook secrets',
    'private transcript text',
    'raw hostnames for future workers',
  ],
}

export function buildAuditRetentionReport(): AuditRetentionReport {
  const actorKinds = new Set(AUDIT_EVENT_CLASSES.flatMap(row => row.actorKinds))
  const resourceKinds = new Set(AUDIT_EVENT_CLASSES.flatMap(row => row.resourceKinds))
  return {
    mode: 'local_beta_redacted_evidence',
    releaseStatus: 'supported_public_local_beta',
    complianceLedgerStatus: 'local_append_only_foundation_not_certified',
    hostedStatus: 'unsupported',
    localEvidenceStatus: 'redacted_evidence_and_incident_bundles_supported',
    rawTranscriptPolicy: 'never_in_compliance_audit_or_shareable_evidence',
    totals: {
      eventClasses: AUDIT_EVENT_CLASSES.length,
      actorKinds: actorKinds.size,
      resourceKinds: resourceKinds.size,
      retentionClasses: AUDIT_RETENTION_POLICIES.length,
      currentSurfaces: AUDIT_CURRENT_SURFACES.length,
      currentSupportedSurfaces: AUDIT_CURRENT_SURFACES.filter(surface => surface.supportedNow).length,
      requiredShapeFields: AUDIT_REQUIRED_SHAPE_FIELDS.length,
    },
    eventClasses: AUDIT_EVENT_CLASSES,
    retentionPolicies: AUDIT_RETENTION_POLICIES,
    currentSurfaces: AUDIT_CURRENT_SURFACES,
    incidentEvidence: INCIDENT_EVIDENCE_CONTRACT,
    ledger: {
      schemaVersion: AUDIT_LEDGER_SCHEMA_VERSION,
      storage: 'gateway.db:audit_ledger',
      appendOnly: true,
      hashChained: true,
      localOnly: true,
      certification: 'not_certified_compliance_storage',
      sourceEventFamilies: ['audit.*', 'human_gate.*', 'delegation.*', 'task.*', 'roadmap.*', 'channel.*', 'project.binding.*', 'evidence.export.*', 'incident.*'],
    },
    caveats: [
      'Current public release supports a local append-only redacted audit ledger foundation plus incident bundles, not certified compliance-grade hosted/team storage.',
      'Workflow events remain local and retention-bound; future self-hosted/team modes need tenant access trails, legal hold, export controls, and operational certification.',
      'Raw transcripts, provider payloads, channel targets, host secrets, and credential values must never enter shareable evidence.',
      'The audit ledger is suitable for local beta evidence and incident triage only; it is not an immutable hosted audit service.',
    ],
  }
}

export function validateAuditEventShape(event: Partial<AuditEventShape>): AuditEventShapeViolation[] {
  const violations: AuditEventShapeViolation[] = []
  const definition = event.class ? AUDIT_EVENT_CLASSES.find(row => row.class === event.class) : undefined

  if (!event.eventId) violations.push({ code: 'missing_required_field', field: 'eventId', message: 'Audit event requires eventId.' })
  if (!event.class || !definition) violations.push({ code: 'unknown_event_class', field: 'class', message: `Unknown audit event class ${String(event.class || '')}.` })
  if (!event.actor?.kind || !definition?.actorKinds.includes(event.actor.kind)) violations.push({ code: 'invalid_actor_kind', field: 'actor.kind', message: `Actor kind ${String(event.actor?.kind || '')} is not allowed for ${String(event.class || 'unknown')}.` })
  if (!event.actor?.idRef) violations.push({ code: 'missing_required_field', field: 'actor.idRef', message: 'Audit event requires a redacted actor id reference.' })
  if (!event.resource?.kind || !definition?.resourceKinds.includes(event.resource.kind)) violations.push({ code: 'invalid_resource_kind', field: 'resource.kind', message: `Resource kind ${String(event.resource?.kind || '')} is not allowed for ${String(event.class || 'unknown')}.` })
  if (!event.resource?.idRef) violations.push({ code: 'missing_required_field', field: 'resource.idRef', message: 'Audit event requires a redacted resource id reference.' })
  if (!event.action) violations.push({ code: 'missing_required_field', field: 'action', message: 'Audit event requires action.' })
  if (!event.result || !['ok', 'denied', 'error'].includes(event.result)) violations.push({ code: 'invalid_result', field: 'result', message: 'Audit event result must be ok, denied, or error.' })
  if (!event.occurredAt || !Number.isFinite(Date.parse(event.occurredAt))) violations.push({ code: 'invalid_timestamp', field: 'occurredAt', message: 'Audit event requires an ISO timestamp.' })
  if (!event.traceId) violations.push({ code: 'missing_required_field', field: 'traceId', message: 'Audit event requires traceId.' })
  if (!event.retentionClass || !AUDIT_RETENTION_POLICIES.some(row => row.class === event.retentionClass)) {
    violations.push({ code: 'invalid_retention_class', field: 'retentionClass', message: 'Audit event retention class is unknown.' })
  } else if (definition && event.retentionClass !== definition.retentionClass) {
    violations.push({ code: 'invalid_retention_class', field: 'retentionClass', message: `Audit event class ${definition.class} must use retention class ${definition.retentionClass}.` })
  }
  if (event.redacted !== true) violations.push({ code: 'redaction_required', field: 'redacted', message: 'Compliance audit event shapes must be redacted before export.' })
  if (!Array.isArray(event.evidenceRefs)) violations.push({ code: 'missing_required_field', field: 'evidenceRefs', message: 'Audit event requires evidenceRefs array.' })

  return violations
}
