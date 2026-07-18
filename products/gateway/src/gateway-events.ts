import type { WorkEventRecord } from './work-store.js'

export const GATEWAY_EVENT_TAXONOMY_VERSION = 1

export type GatewayEventVisibility = 'operator' | 'support' | 'evidence' | 'internal'
export type GatewayEventAudience = 'dashboard' | 'channel' | 'support_bundle' | 'evidence_ledger' | 'supervisor' | 'scheduler'
export type GatewayEventSourceKind = 'work_store' | 'scheduler' | 'channel' | 'supervisor' | 'human_loop' | 'evidence' | 'security' | 'system'

export type GatewayEventName =
  | 'alert.lifecycle.detected'
  | 'alert.lifecycle.resolved'
  | 'attention.human_decision.recorded'
  | 'attention.opencode_request.notified'
  | 'attention.opencode_request.notify_failed'
  | 'attention.gateway_gate.created'
  | 'attention.gateway_gate.consumed'
  | 'attention.gateway_gate.decided'
  | 'attention.gateway_gate.escalated'
  | 'attention.gateway_gate.rejected_task'
  | 'attention.gateway_gate.reminded'
  | 'channel.binding.deleted'
  | 'channel.binding.upserted'
  | 'channel.claim.denied'
  | 'channel.notification.failed'
  | 'channel.notification.sent'
  | 'channel.notification.suppressed'
  | 'delegation.lifecycle.accepted'
  | 'delegation.lifecycle.mapped'
  | 'delegation.progress.recorded'
  | 'delegation.progress.delivery_failed'
  | 'delegation.progress.delivery_succeeded'
  | 'delegation.progress.delivery_suppressed'
  | 'evidence.export.written'
  | 'fleet.admission.denied'
  | 'fleet.cleanup.failed'
  | 'fleet.lease.acquired'
  | 'fleet.lease.recovered'
  | 'fleet.lease.released'
  | 'fleet.result.accepted'
  | 'fleet.worker.heartbeat'
  | 'fleet.worker.registered'
  | 'promotion.decision.requested'
  | 'promotion.scorecard.upserted'
  | 'roadmap.completion.approved'
  | 'roadmap.completion.auto_blocked'
  | 'roadmap.completion.proposed'
  | 'roadmap.completion.rejected'
  | 'roadmap.lifecycle.archived'
  | 'roadmap.lifecycle.created'
  | 'roadmap.lifecycle.created_with_tasks'
  | 'roadmap.lifecycle.deleted'
  | 'roadmap.lifecycle.recomputed'
  | 'roadmap.lifecycle.updated'
  | 'run.dispatch.failed'
  | 'run.dispatch.started'
  | 'run.dispatch.start_expired'
  | 'run.dispatch.starting'
  | 'run.environment.attached'
  | 'run.environment.hydrated'
  | 'run.environment.prepared'
  | 'run.environment.reconciled'
  | 'run.environment.released'
  | 'run.lifecycle.attribution_updated'
  | 'run.lifecycle.completed'
  | 'run.lifecycle.failed'
  | 'run.lifecycle.lease_expired'
  | 'run.lifecycle.lease_renewed'
  | 'run.lifecycle.operator_controlled'
  | 'run.lifecycle.started'
  | 'security.audit.recorded'
  | 'storage.recovery.completed'
  | 'storage.recovery.started'
  | 'supervisor.action.rejected'
  | 'supervisor.lifecycle.archived'
  | 'supervisor.lifecycle.created'
  | 'supervisor.lifecycle.updated'
  | 'supervisor.permission.requested'
  | 'supervisor.question.requested'
  | 'supervisor.result.applied'
  | 'supervisor.review.requested'
  | 'supervisor.tasks.proposed'
  | 'supervisor.wakeup.acquired'
  | 'team_assignment.briefing.failed'
  | 'team_assignment.briefing.notified'
  | 'team_assignment.briefing.suppressed'
  | 'team_assignment.lifecycle.completed'
  | 'team_assignment.lifecycle.created'
  | 'team_assignment.lifecycle.gate_result'
  | 'team_assignment.lifecycle.rejected'
  | 'team_assignment.lifecycle.review_outcome'
  | 'task.dependency.created'
  | 'task.dependency.deleted'
  | 'task.lifecycle.archived'
  | 'task.lifecycle.created'
  | 'task.lifecycle.deleted'
  | 'task.lifecycle.done_manual'
  | 'task.lifecycle.updated'
  | 'task.lifecycle.updated_bulk'
  | 'workflow.runtime_profile.rejected'
  | 'workflow.runtime_profile.validated'
  | 'workflow.runtime_capability_grant.rejected'
  | 'workflow.runtime_capability_grant.validated'
  | 'workflow.soak.recovered'
  | 'workflow.review_gate.isolation_enforced'
  | 'workflow.demo.created'
  | 'workflow.project_wizard.created'

export interface GatewayEventCorrelation {
  eventId: number
  legacyType: string
  subjectId?: string
  taskId?: string
  roadmapId?: string
  runId?: string
  sessionId?: string
  dispatchId?: string
  gateId?: string
  supervisorId?: string
  idempotencyKey?: string
  progressKey?: string
  dedupeKey?: string
  provider?: string
  targetKey?: string
}

export interface GatewayEventEnvelope {
  taxonomyVersion: typeof GATEWAY_EVENT_TAXONOMY_VERSION
  name: GatewayEventName
  legacyType: string
  source: {
    kind: GatewayEventSourceKind
    name: string
  }
  destination?: {
    kind: 'opencode_session' | 'channel_target' | 'work_item' | 'operator' | 'support_bundle'
    id: string
  }
  visibility: GatewayEventVisibility
  audience: GatewayEventAudience[]
  subjectId?: string
  correlation: GatewayEventCorrelation
  payload: Record<string, unknown>
  createdAt: string
  processedAt?: string
  durable: true
  idempotencyKey?: string
}

export interface GatewayEventValidationResult {
  ok: boolean
  errors: string[]
}

export interface GatewayEventSubscription {
  names?: GatewayEventName[]
  prefixes?: string[]
  legacyTypes?: string[]
  sourceKinds?: GatewayEventSourceKind[]
  visibility?: GatewayEventVisibility[]
  audience?: GatewayEventAudience[]
  subjects?: string[]
  since?: Date | string
  until?: Date | string
  correlation?: Partial<Record<keyof GatewayEventCorrelation, string | string[]>>
  order?: 'asc' | 'desc'
  limit?: number
}

interface GatewayEventDescriptor {
  name: GatewayEventName
  sourceKind: GatewayEventSourceKind
  visibility: GatewayEventVisibility
  audience: GatewayEventAudience[]
}

export const LEGACY_WORK_EVENT_TO_GATEWAY_EVENT: Record<string, GatewayEventDescriptor> = {
  'alert.detected': descriptor('alert.lifecycle.detected', 'system', 'support', ['dashboard', 'support_bundle', 'supervisor']),
  'alert.resolved': descriptor('alert.lifecycle.resolved', 'system', 'support', ['dashboard', 'support_bundle']),
  'audit.human_decision': descriptor('attention.human_decision.recorded', 'human_loop', 'support', ['dashboard', 'support_bundle', 'evidence_ledger']),
  'audit.security': descriptor('security.audit.recorded', 'security', 'evidence', ['support_bundle', 'evidence_ledger', 'dashboard']),
  'channel.binding.deleted': descriptor('channel.binding.deleted', 'channel', 'operator', ['dashboard', 'channel', 'support_bundle']),
  'channel.binding.upserted': descriptor('channel.binding.upserted', 'channel', 'operator', ['dashboard', 'channel', 'support_bundle']),
  'channel.claim.denied': descriptor('channel.claim.denied', 'channel', 'support', ['dashboard', 'channel', 'support_bundle', 'evidence_ledger']),
  'delegation.accepted': descriptor('delegation.lifecycle.accepted', 'work_store', 'operator', ['dashboard', 'channel', 'support_bundle', 'supervisor']),
  'delegation.mapped': descriptor('delegation.lifecycle.mapped', 'work_store', 'operator', ['dashboard', 'channel', 'support_bundle', 'supervisor']),
  'delegation.progress': descriptor('delegation.progress.recorded', 'work_store', 'operator', ['dashboard', 'channel', 'support_bundle', 'supervisor']),
  'delegation.progress.failed': descriptor('delegation.progress.delivery_failed', 'channel', 'support', ['dashboard', 'channel', 'support_bundle']),
  'delegation.progress.notified': descriptor('delegation.progress.delivery_succeeded', 'channel', 'operator', ['dashboard', 'channel', 'support_bundle']),
  'delegation.progress.suppressed': descriptor('delegation.progress.delivery_suppressed', 'channel', 'support', ['dashboard', 'channel', 'support_bundle']),
  'demo.created': descriptor('workflow.demo.created', 'system', 'internal', ['dashboard']),
  'environment.attached': descriptor('run.environment.attached', 'scheduler', 'support', ['dashboard', 'support_bundle']),
  'environment.hydrated': descriptor('run.environment.hydrated', 'scheduler', 'support', ['dashboard', 'support_bundle']),
  'environment.prepared': descriptor('run.environment.prepared', 'scheduler', 'support', ['dashboard', 'support_bundle']),
  'environment.released': descriptor('run.environment.released', 'scheduler', 'support', ['dashboard', 'support_bundle']),
  'environments': descriptor('run.environment.reconciled', 'scheduler', 'support', ['dashboard', 'support_bundle']),
  'evidence.export.written': descriptor('evidence.export.written', 'evidence', 'evidence', ['evidence_ledger', 'support_bundle', 'dashboard']),
  'human_gate.consumed': descriptor('attention.gateway_gate.consumed', 'human_loop', 'operator', ['dashboard', 'channel', 'support_bundle']),
  'human_gate.created': descriptor('attention.gateway_gate.created', 'human_loop', 'operator', ['dashboard', 'channel', 'support_bundle', 'supervisor']),
  'human_gate.decided': descriptor('attention.gateway_gate.decided', 'human_loop', 'operator', ['dashboard', 'channel', 'support_bundle', 'evidence_ledger']),
  'human_gate.escalated': descriptor('attention.gateway_gate.escalated', 'human_loop', 'support', ['dashboard', 'channel', 'support_bundle']),
  'human_gate.rejected_task': descriptor('attention.gateway_gate.rejected_task', 'human_loop', 'support', ['dashboard', 'channel', 'support_bundle']),
  'human_gate.reminded': descriptor('attention.gateway_gate.reminded', 'human_loop', 'operator', ['dashboard', 'channel', 'support_bundle']),
  'live_state_hygiene.reset': descriptor('workflow.review_gate.isolation_enforced', 'system', 'support', ['dashboard', 'support_bundle']),
  'opencode.request.notified': descriptor('attention.opencode_request.notified', 'channel', 'operator', ['dashboard', 'channel', 'support_bundle']),
  'opencode.request.notify_failed': descriptor('attention.opencode_request.notify_failed', 'channel', 'support', ['dashboard', 'channel', 'support_bundle']),
  'project.binding.deleted': descriptor('channel.binding.deleted', 'channel', 'operator', ['dashboard', 'channel', 'support_bundle']),
  'project.binding.updated': descriptor('channel.binding.upserted', 'channel', 'operator', ['dashboard', 'channel', 'support_bundle']),
  'project.binding.upserted': descriptor('channel.binding.upserted', 'channel', 'operator', ['dashboard', 'channel', 'support_bundle']),
  'project.notification.failed': descriptor('channel.notification.failed', 'channel', 'support', ['dashboard', 'channel', 'support_bundle']),
  'project.notification.sent': descriptor('channel.notification.sent', 'channel', 'operator', ['dashboard', 'channel', 'support_bundle']),
  'project.notification.suppressed': descriptor('channel.notification.suppressed', 'channel', 'support', ['dashboard', 'channel', 'support_bundle']),
  'project.wizard.created': descriptor('workflow.project_wizard.created', 'system', 'operator', ['dashboard']),
  'promotion.decision.requested': descriptor('promotion.decision.requested', 'human_loop', 'operator', ['dashboard', 'support_bundle', 'evidence_ledger']),
  'promotion.scorecard.upserted': descriptor('promotion.scorecard.upserted', 'evidence', 'evidence', ['dashboard', 'support_bundle', 'evidence_ledger']),
  'review_gate.isolation.enforced': descriptor('workflow.review_gate.isolation_enforced', 'security', 'evidence', ['support_bundle', 'evidence_ledger', 'dashboard']),
  'roadmap.archived': descriptor('roadmap.lifecycle.archived', 'work_store', 'operator', ['dashboard', 'support_bundle']),
  'roadmap.completion.approved': descriptor('roadmap.completion.approved', 'supervisor', 'operator', ['dashboard', 'channel', 'support_bundle', 'evidence_ledger']),
  'roadmap.completion.auto_blocked': descriptor('roadmap.completion.auto_blocked', 'supervisor', 'support', ['dashboard', 'support_bundle', 'supervisor']),
  'roadmap.completion.proposed': descriptor('roadmap.completion.proposed', 'supervisor', 'operator', ['dashboard', 'channel', 'support_bundle', 'supervisor']),
  'roadmap.completion.rejected': descriptor('roadmap.completion.rejected', 'supervisor', 'operator', ['dashboard', 'channel', 'support_bundle', 'evidence_ledger']),
  'roadmap.created': descriptor('roadmap.lifecycle.created', 'work_store', 'operator', ['dashboard', 'support_bundle']),
  'roadmap.created_with_tasks': descriptor('roadmap.lifecycle.created_with_tasks', 'work_store', 'operator', ['dashboard', 'support_bundle']),
  'roadmap.deleted': descriptor('roadmap.lifecycle.deleted', 'work_store', 'support', ['dashboard', 'support_bundle']),
  'roadmap.recomputed': descriptor('roadmap.lifecycle.recomputed', 'work_store', 'internal', ['dashboard', 'support_bundle']),
  'roadmap.updated': descriptor('roadmap.lifecycle.updated', 'work_store', 'operator', ['dashboard', 'support_bundle']),
  'roadmap.supervisor.action_rejected': descriptor('supervisor.action.rejected', 'supervisor', 'support', ['dashboard', 'support_bundle', 'supervisor']),
  'roadmap.supervisor.archived': descriptor('supervisor.lifecycle.archived', 'supervisor', 'operator', ['dashboard', 'support_bundle']),
  'roadmap.supervisor.created': descriptor('supervisor.lifecycle.created', 'supervisor', 'operator', ['dashboard', 'support_bundle', 'supervisor']),
  'roadmap.supervisor.permission_requested': descriptor('supervisor.permission.requested', 'supervisor', 'operator', ['dashboard', 'channel', 'support_bundle', 'supervisor']),
  'roadmap.supervisor.questions_requested': descriptor('supervisor.question.requested', 'supervisor', 'operator', ['dashboard', 'channel', 'support_bundle', 'supervisor']),
  'roadmap.supervisor.result_applied': descriptor('supervisor.result.applied', 'supervisor', 'operator', ['dashboard', 'support_bundle', 'supervisor']),
  'roadmap.supervisor.review_requested': descriptor('supervisor.review.requested', 'supervisor', 'operator', ['dashboard', 'channel', 'support_bundle', 'supervisor']),
  'roadmap.supervisor.tasks_proposed': descriptor('supervisor.tasks.proposed', 'supervisor', 'operator', ['dashboard', 'channel', 'support_bundle', 'supervisor']),
  'roadmap.supervisor.updated': descriptor('supervisor.lifecycle.updated', 'supervisor', 'operator', ['dashboard', 'support_bundle', 'supervisor']),
  'roadmap.supervisor.wakeup_acquired': descriptor('supervisor.wakeup.acquired', 'supervisor', 'operator', ['dashboard', 'support_bundle', 'supervisor']),
  'runtime.capability_grant.rejected': descriptor('workflow.runtime_capability_grant.rejected', 'security', 'support', ['dashboard', 'support_bundle', 'evidence_ledger']),
  'runtime.capability_grant.validated': descriptor('workflow.runtime_capability_grant.validated', 'security', 'support', ['dashboard', 'support_bundle', 'evidence_ledger']),
  'runtime.profile.rejected': descriptor('workflow.runtime_profile.rejected', 'security', 'support', ['dashboard', 'support_bundle']),
  'runtime.profile.validated': descriptor('workflow.runtime_profile.validated', 'security', 'support', ['dashboard', 'support_bundle']),
  'soak.failure_injection.recovered': descriptor('workflow.soak.recovered', 'system', 'evidence', ['dashboard', 'support_bundle', 'evidence_ledger']),
  'storage.recovery_drill.completed': descriptor('storage.recovery.completed', 'system', 'evidence', ['dashboard', 'support_bundle', 'evidence_ledger']),
  'storage.recovery_drill.started': descriptor('storage.recovery.started', 'system', 'evidence', ['dashboard', 'support_bundle', 'evidence_ledger']),
  'task.archived': descriptor('task.lifecycle.archived', 'work_store', 'operator', ['dashboard', 'support_bundle']),
  'task.created': descriptor('task.lifecycle.created', 'work_store', 'operator', ['dashboard', 'support_bundle', 'supervisor']),
  'task.deleted': descriptor('task.lifecycle.deleted', 'work_store', 'support', ['dashboard', 'support_bundle']),
  'task.dependency.created': descriptor('task.dependency.created', 'work_store', 'operator', ['dashboard', 'support_bundle', 'supervisor']),
  'task.dependency.deleted': descriptor('task.dependency.deleted', 'work_store', 'support', ['dashboard', 'support_bundle']),
  'task.dispatch.failed': descriptor('run.dispatch.failed', 'scheduler', 'support', ['dashboard', 'support_bundle', 'scheduler']),
  'task.dispatch.started': descriptor('run.dispatch.started', 'scheduler', 'operator', ['dashboard', 'support_bundle', 'scheduler']),
  'task.dispatch.start_expired': descriptor('run.dispatch.start_expired', 'scheduler', 'support', ['dashboard', 'support_bundle', 'scheduler']),
  'task.dispatch.starting': descriptor('run.dispatch.starting', 'scheduler', 'operator', ['dashboard', 'support_bundle', 'scheduler']),
  'task.done.manual': descriptor('task.lifecycle.done_manual', 'work_store', 'operator', ['dashboard', 'channel', 'support_bundle', 'supervisor']),
  'task.run.attribution_updated': descriptor('run.lifecycle.attribution_updated', 'scheduler', 'support', ['dashboard', 'support_bundle']),
  'task.run.completed': descriptor('run.lifecycle.completed', 'scheduler', 'operator', ['dashboard', 'channel', 'support_bundle', 'supervisor']),
  'task.run.lease_expired': descriptor('run.lifecycle.lease_expired', 'scheduler', 'support', ['dashboard', 'support_bundle', 'scheduler']),
  'task.run.lease_renewed': descriptor('run.lifecycle.lease_renewed', 'scheduler', 'internal', ['dashboard', 'support_bundle', 'scheduler']),
  'task.run.operator_controlled': descriptor('run.lifecycle.operator_controlled', 'work_store', 'operator', ['dashboard', 'channel', 'support_bundle', 'scheduler']),
  'task.run.prompt_failed': descriptor('run.lifecycle.failed', 'scheduler', 'support', ['dashboard', 'channel', 'support_bundle', 'supervisor']),
  'task.run.started': descriptor('run.lifecycle.started', 'scheduler', 'operator', ['dashboard', 'channel', 'support_bundle', 'supervisor', 'scheduler']),
  'task.updated': descriptor('task.lifecycle.updated', 'work_store', 'operator', ['dashboard', 'support_bundle', 'supervisor']),
  'task.updated.bulk': descriptor('task.lifecycle.updated_bulk', 'work_store', 'operator', ['dashboard', 'support_bundle', 'supervisor']),
  'team_assignment.briefing.failed': descriptor('team_assignment.briefing.failed', 'channel', 'support', ['dashboard', 'support_bundle']),
  'team_assignment.briefing.notified': descriptor('team_assignment.briefing.notified', 'channel', 'operator', ['dashboard', 'channel', 'support_bundle']),
  'team_assignment.briefing.suppressed': descriptor('team_assignment.briefing.suppressed', 'channel', 'support', ['dashboard', 'support_bundle']),
  'team_assignment.completion': descriptor('team_assignment.lifecycle.completed', 'work_store', 'operator', ['dashboard', 'support_bundle', 'evidence_ledger']),
  'team_assignment.created': descriptor('team_assignment.lifecycle.created', 'work_store', 'operator', ['dashboard', 'support_bundle', 'supervisor']),
  'team_assignment.gate_result': descriptor('team_assignment.lifecycle.gate_result', 'human_loop', 'operator', ['dashboard', 'channel', 'support_bundle']),
  'team_assignment.rejected': descriptor('team_assignment.lifecycle.rejected', 'work_store', 'support', ['dashboard', 'support_bundle']),
  'team_assignment.review_outcome': descriptor('team_assignment.lifecycle.review_outcome', 'evidence', 'operator', ['dashboard', 'support_bundle', 'evidence_ledger']),
  'team_orchestration_eval.completed': descriptor('team_assignment.lifecycle.review_outcome', 'evidence', 'evidence', ['dashboard', 'support_bundle', 'evidence_ledger']),
}

const GATEWAY_EVENT_NAME_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*){2,}$/
const KNOWN_GATEWAY_EVENT_NAMES = new Set<GatewayEventName>(
  Object.values(LEGACY_WORK_EVENT_TO_GATEWAY_EVENT).map(entry => entry.name),
)


export function validateGatewayEventName(value: unknown): GatewayEventValidationResult {
  const errors: string[] = []
  if (typeof value !== 'string' || !value) errors.push('event name must be a non-empty string')
  else {
    if (!GATEWAY_EVENT_NAME_PATTERN.test(value)) errors.push(`event name must be stable hierarchical lowercase dot notation: ${value}`)
    if (!KNOWN_GATEWAY_EVENT_NAMES.has(value as GatewayEventName)) errors.push(`event name is not in the Gateway taxonomy: ${value}`)
  }
  return { ok: errors.length === 0, errors }
}

export function gatewayEventFromWorkEvent(event: WorkEventRecord): GatewayEventEnvelope {
  const descriptor = LEGACY_WORK_EVENT_TO_GATEWAY_EVENT[event.type]
  if (!descriptor) throw new Error(`unmapped Gateway work event type: ${event.type}`)
  const correlation = buildCorrelation(event)
  const envelope: GatewayEventEnvelope = {
    taxonomyVersion: GATEWAY_EVENT_TAXONOMY_VERSION,
    name: descriptor.name,
    legacyType: event.type,
    source: {
      kind: descriptor.sourceKind,
      name: descriptor.sourceKind === 'work_store' ? 'gateway.work_store' : `gateway.${descriptor.sourceKind}`,
    },
    destination: destinationForEvent(event, correlation),
    visibility: descriptor.visibility,
    audience: [...descriptor.audience],
    subjectId: event.subjectId,
    correlation,
    payload: { ...event.payload },
    createdAt: event.createdAt,
    processedAt: event.processedAt,
    durable: true,
    idempotencyKey: correlation.idempotencyKey,
  }
  const validation = validateGatewayEvent(envelope)
  if (!validation.ok) throw new Error(`invalid Gateway event ${event.type}: ${validation.errors.join('; ')}`)
  return envelope
}

export function validateGatewayEvent(event: GatewayEventEnvelope): GatewayEventValidationResult {
  const errors: string[] = []
  const name = validateGatewayEventName(event.name)
  errors.push(...name.errors)
  if (event.taxonomyVersion !== GATEWAY_EVENT_TAXONOMY_VERSION) errors.push(`taxonomy version must be ${GATEWAY_EVENT_TAXONOMY_VERSION}`)
  if (!event.legacyType) errors.push('legacyType is required')
  if (!event.source?.kind || !event.source.name) errors.push('source kind and name are required')
  if (!event.createdAt || Number.isNaN(Date.parse(event.createdAt))) errors.push('createdAt must be an ISO timestamp')
  if (!Number.isInteger(event.correlation?.eventId) || event.correlation.eventId <= 0) errors.push('correlation.eventId must be a positive integer')
  if (event.correlation?.legacyType !== event.legacyType) errors.push('correlation.legacyType must match legacyType')
  if (event.subjectId !== event.correlation?.subjectId) errors.push('subjectId must match correlation.subjectId')
  if (!event.audience?.length) errors.push('audience must include at least one read-model consumer')
  if (event.durable !== true) errors.push('Gateway work event envelopes must be marked durable')
  return { ok: errors.length === 0, errors }
}

export function gatewayEventsFromWorkEvents(events: WorkEventRecord[]): GatewayEventEnvelope[] {
  return events.map(gatewayEventFromWorkEvent)
}

export function filterGatewayEvents(events: GatewayEventEnvelope[], subscription: GatewayEventSubscription = {}): GatewayEventEnvelope[] {
  const since = timestamp(subscription.since)
  const until = timestamp(subscription.until)
  const limit = clampLimit(subscription.limit, events.length || 1)
  const filtered = events.filter(event => {
    if (subscription.names?.length && !subscription.names.includes(event.name)) return false
    if (subscription.prefixes?.length && !subscription.prefixes.some(prefix => event.name === prefix || event.name.startsWith(`${prefix}.`))) return false
    if (subscription.legacyTypes?.length && !subscription.legacyTypes.includes(event.legacyType)) return false
    if (subscription.sourceKinds?.length && !subscription.sourceKinds.includes(event.source.kind)) return false
    if (subscription.visibility?.length && !subscription.visibility.includes(event.visibility)) return false
    if (subscription.audience?.length && !subscription.audience.some(audience => event.audience.includes(audience))) return false
    if (subscription.subjects?.length && (!event.subjectId || !subscription.subjects.includes(event.subjectId))) return false
    const createdAt = Date.parse(event.createdAt)
    if (since !== undefined && createdAt < since) return false
    if (until !== undefined && createdAt > until) return false
    if (!matchesCorrelation(event.correlation, subscription.correlation)) return false
    return true
  })
  filtered.sort((a, b) => a.correlation.eventId - b.correlation.eventId)
  if (subscription.order === 'desc') filtered.reverse()
  return filtered.slice(0, limit)
}

export function filterWorkEventsByGatewaySubscription(events: WorkEventRecord[], subscription: GatewayEventSubscription = {}): WorkEventRecord[] {
  const byId = new Map(events.map(event => [event.id, event]))
  return filterGatewayEvents(gatewayEventsFromWorkEvents(events), subscription)
    .map(event => byId.get(event.correlation.eventId))
    .filter((event): event is WorkEventRecord => Boolean(event))
}

function descriptor(name: GatewayEventName, sourceKind: GatewayEventSourceKind, visibility: GatewayEventVisibility, audience: GatewayEventAudience[]): GatewayEventDescriptor {
  return { name, sourceKind, visibility, audience }
}

function buildCorrelation(event: WorkEventRecord): GatewayEventCorrelation {
  const payload = event.payload || {}
  return {
    eventId: event.id,
    legacyType: event.type,
    subjectId: event.subjectId,
    taskId: stringValue(payload['taskId']) || taskIdFromSubject(event),
    roadmapId: stringValue(payload['roadmapId']),
    runId: stringValue(payload['runId']),
    sessionId: stringValue(payload['sessionId']) || stringValue(payload['parentSessionId']),
    dispatchId: stringValue(payload['dispatchId']),
    gateId: stringValue(payload['gateId']),
    supervisorId: stringValue(payload['supervisorId']),
    idempotencyKey: stringValue(payload['idempotencyKey']),
    progressKey: stringValue(payload['progressKey']),
    dedupeKey: stringValue(payload['dedupeKey']) || (event.type.startsWith('delegation.progress.') ? event.subjectId : undefined),
    provider: stringValue(payload['provider']),
    targetKey: stringValue(payload['targetKey']),
  }
}

function destinationForEvent(event: WorkEventRecord, correlation: GatewayEventCorrelation): GatewayEventEnvelope['destination'] {
  if (correlation.sessionId) return { kind: 'opencode_session', id: correlation.sessionId }
  if (correlation.provider && correlation.targetKey) return { kind: 'channel_target', id: `${correlation.provider}:${correlation.targetKey}` }
  if (correlation.taskId || correlation.roadmapId || event.subjectId) return { kind: 'work_item', id: correlation.taskId || correlation.roadmapId || event.subjectId! }
  return undefined
}

function matchesCorrelation(correlation: GatewayEventCorrelation, expected: GatewayEventSubscription['correlation']): boolean {
  if (!expected) return true
  return Object.entries(expected).every(([key, value]) => {
    const actual = correlation[key as keyof GatewayEventCorrelation]
    const allowed = Array.isArray(value) ? value : [value]
    return typeof actual === 'string' || typeof actual === 'number'
      ? allowed.map(String).includes(String(actual))
      : false
  })
}

function timestamp(value: Date | string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function clampLimit(value: number | undefined, fallback: number): number {
  return Math.max(1, Math.min(value || fallback, 5000))
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function taskIdFromSubject(event: WorkEventRecord): string | undefined {
  if (!event.subjectId) return undefined
  if (event.type.startsWith('task.') || event.type.startsWith('delegation.')) return event.subjectId
  return undefined
}
