import { createHash } from 'node:crypto'
import {
  AUDIT_LEDGER_SCHEMA_VERSION,
  validateAuditEventShape,
  type AuditActorKind,
  type AuditEventClass,
  type AuditResourceKind,
  type AuditRetentionClass,
} from './audit-retention.js'
import { replacePhoneLikeText, replacePrivateText, replaceProviderTargetText, replaceSessionIdText } from './operational-redaction.js'
import { redactSensitiveText } from './security.js'
import type { WorkEventRecord } from './work-store.js'

export interface AuditLedgerRecord {
  id: number
  schemaVersion: typeof AUDIT_LEDGER_SCHEMA_VERSION
  eventId: string
  sourceEventId?: number
  sourceEventType?: string
  class: AuditEventClass
  actorKind: AuditActorKind
  actorRef: string
  resourceKind: AuditResourceKind
  resourceRef: string
  action: string
  result: 'ok' | 'denied' | 'error'
  occurredAt: string
  traceId: string
  correlationId?: string
  retentionClass: AuditRetentionClass
  evidenceRefs: string[]
  redactedPayload: Record<string, unknown>
  previousHash?: string
  entryHash: string
}

export interface AuditLedgerQueryOptions {
  limit?: number
  since?: string
  until?: string
  traceId?: string
  correlationId?: string
  class?: AuditEventClass
  sourceEventType?: string
}

interface LedgerSemantics {
  class: AuditEventClass
  actorKind: AuditActorKind
  actorRefInput: unknown
  resourceKind: AuditResourceKind
  resourceRefInput: unknown
  action: string
  result: 'ok' | 'denied' | 'error'
  retentionClass: AuditRetentionClass
}

const SECRET_KEY_PATTERN = /(token|secret|password|credential|private[_-]?key|api[_-]?key|signature|webhook)/i
const PRIVATE_TEXT_KEY_PATTERN = /^(body|content|description|feedback|message|note|prompt|raw|summary|text|transcript)$/i
const REF_KEY_PATTERN = /(actor|chat|channel|environment|host|lease|path|principal|providerTarget|session|source|subject|target|thread|user|worker|workdir)/i

export function auditLedgerRecordFromWorkEvent(event: WorkEventRecord, previousHash?: string): AuditLedgerRecord | undefined {
  const semantics = classifyWorkEvent(event)
  if (!semantics) return undefined
  const occurredAt = normalizeIsoTime(event.createdAt)
  const redactedPayload = redactAuditLedgerPayload(event.payload)
  const traceId = traceIdForEvent(event, semantics)
  const correlationId = correlationIdForEvent(event)
  const evidenceRefs = [`work_event:${event.id}`]
  const actorRef = redactedRef(semantics.actorKind, semantics.actorRefInput)
  const resourceRef = redactedRef(semantics.resourceKind, semantics.resourceRefInput || event.subjectId || event.type)
  const shape = {
    eventId: `audit_evt_${event.id}`,
    class: semantics.class,
    actor: { kind: semantics.actorKind, idRef: actorRef },
    resource: { kind: semantics.resourceKind, idRef: resourceRef },
    action: semantics.action,
    result: semantics.result,
    occurredAt,
    traceId,
    retentionClass: semantics.retentionClass,
    redacted: true,
    evidenceRefs,
  }
  const violations = validateAuditEventShape(shape)
  if (violations.length) {
    throw new Error(`invalid audit ledger row for ${event.type}: ${violations.map(row => `${row.code}:${row.field || 'shape'}`).join(', ')}`)
  }
  const withoutHash: Omit<AuditLedgerRecord, 'entryHash'> = {
    id: 0,
    schemaVersion: AUDIT_LEDGER_SCHEMA_VERSION,
    eventId: shape.eventId,
    sourceEventId: event.id,
    sourceEventType: event.type,
    class: semantics.class,
    actorKind: semantics.actorKind,
    actorRef,
    resourceKind: semantics.resourceKind,
    resourceRef,
    action: semantics.action,
    result: semantics.result,
    occurredAt,
    traceId,
    correlationId,
    retentionClass: semantics.retentionClass,
    evidenceRefs,
    redactedPayload,
    previousHash,
  }
  return {
    ...withoutHash,
    entryHash: auditLedgerEntryHash(withoutHash),
  }
}

export function redactAuditLedgerPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return redactPayloadObject(payload, 0) as Record<string, unknown>
}

export function auditLedgerEntryHash(record: Omit<AuditLedgerRecord, 'entryHash'>): string {
  return hashText(canonicalJson(record))
}

function classifyWorkEvent(event: WorkEventRecord): LedgerSemantics | undefined {
  const type = event.type
  const payload = event.payload || {}
  if (type === 'audit.security') return classifySecurityAudit(event)
  if (type === 'audit.human_decision' || type.startsWith('human_gate.')) {
    return {
      class: 'human_gate_decision',
      actorKind: 'local_operator',
      actorRefInput: payload['actor'] || payload['decidedBy'] || 'local_operator',
      resourceKind: 'human_gate',
      resourceRefInput: event.subjectId || payload['gateId'] || payload['id'] || type,
      action: type,
      result: resultFromPayload(payload),
      retentionClass: 'security_audit',
    }
  }
  if (type.startsWith('channel.') || type.startsWith('project.binding.') || type.startsWith('channel_claim.')) {
    return {
      class: 'channel_event',
      actorKind: 'connector',
      actorRefInput: payload['provider'] || 'gateway_channel_connector',
      resourceKind: 'channel_binding',
      resourceRefInput: providerTargetRefInput(payload, event.subjectId || type),
      action: type,
      result: resultFromPayload(payload),
      retentionClass: 'security_audit',
    }
  }
  if (type.includes('secret') || type.includes('vault')) {
    return {
      class: 'secret_reference',
      actorKind: 'gateway_system',
      actorRefInput: payload['actor'] || 'gateway_secret_boundary',
      resourceKind: 'secret_reference',
      resourceRefInput: payload['secretRef'] || payload['referenceId'] || event.subjectId || type,
      action: type,
      result: resultFromPayload(payload),
      retentionClass: 'secret_metadata',
    }
  }
  if (type.startsWith('evidence.export')) {
    return {
      class: 'evidence_export',
      actorKind: 'local_operator',
      actorRefInput: payload['actor'] || 'local_operator',
      resourceKind: 'evidence_export',
      resourceRefInput: payload['bundleId'] || event.subjectId || type,
      action: type,
      result: resultFromPayload(payload),
      retentionClass: 'incident_evidence',
    }
  }
  if (type.startsWith('incident.') || type.startsWith('alert.')) {
    return {
      class: 'incident_response',
      actorKind: 'gateway_system',
      actorRefInput: payload['actor'] || 'gateway_incident_response',
      resourceKind: 'incident_bundle',
      resourceRefInput: payload['bundleId'] || payload['alertId'] || event.subjectId || type,
      action: type,
      result: resultFromPayload(payload),
      retentionClass: 'incident_evidence',
    }
  }
  if (type.startsWith('runtime.')) {
    return {
      class: 'security_decision',
      actorKind: 'gateway_system',
      actorRefInput: payload['actor'] || 'gateway_runtime_boundary',
      resourceKind: 'task',
      resourceRefInput: payload['taskId'] || payload['runId'] || event.subjectId || type,
      action: type,
      result: type.includes('.rejected') ? 'denied' : resultFromPayload(payload),
      retentionClass: 'security_audit',
    }
  }
  if (type.startsWith('delegation.') || type.startsWith('task.dispatch.') || type.startsWith('roadmap.supervisor.') || type.startsWith('environment.') || type.startsWith('capacity.')) {
    return {
      class: 'scheduler_transition',
      actorKind: 'gateway_system',
      actorRefInput: payload['leaseOwner'] || payload['supervisorId'] || 'gateway_scheduler',
      resourceKind: type.startsWith('roadmap.supervisor.') || type.startsWith('capacity.') ? 'worker_pool' : 'task',
      resourceRefInput: payload['taskId'] || payload['runId'] || payload['roadmapId'] || payload['supervisorId'] || event.subjectId || type,
      action: type,
      result: resultFromPayload(payload),
      retentionClass: 'local_beta_work_history',
    }
  }
  if (type.startsWith('task.run.') || type.startsWith('run.')) {
    return {
      class: 'agent_action',
      actorKind: 'agent',
      actorRefInput: payload['profile'] || payload['agent'] || 'opencode_agent',
      resourceKind: 'run',
      resourceRefInput: payload['runId'] || event.subjectId || type,
      action: type,
      result: resultFromPayload(payload),
      retentionClass: 'local_beta_work_history',
    }
  }
  if (type.startsWith('task.') || type.startsWith('roadmap.')) {
    return {
      class: 'user_action',
      actorKind: 'local_operator',
      actorRefInput: payload['actor'] || 'local_operator',
      resourceKind: type.startsWith('roadmap.') ? 'roadmap' : 'task',
      resourceRefInput: event.subjectId || payload['taskId'] || payload['roadmapId'] || type,
      action: type,
      result: resultFromPayload(payload),
      retentionClass: 'local_beta_work_history',
    }
  }
  return undefined
}

function classifySecurityAudit(event: WorkEventRecord): LedgerSemantics {
  const payload = event.payload || {}
  const operation = stringOr(payload['operation'], event.type)
  if (operation.startsWith('storage.')) {
    return {
      class: 'storage_admin',
      actorKind: 'local_operator',
      actorRefInput: payload['actor'] || 'local_operator',
      resourceKind: 'storage',
      resourceRefInput: payload['target'] || event.subjectId || operation,
      action: operation,
      result: resultFromPayload(payload),
      retentionClass: 'security_audit',
    }
  }
  if (operation.startsWith('config.')) {
    return {
      class: 'config_admin',
      actorKind: 'local_operator',
      actorRefInput: payload['actor'] || 'local_operator',
      resourceKind: 'config',
      resourceRefInput: payload['target'] || event.subjectId || operation,
      action: operation,
      result: resultFromPayload(payload),
      retentionClass: 'security_audit',
    }
  }
  if (operation.includes('incident')) {
    return {
      class: 'incident_response',
      actorKind: 'gateway_system',
      actorRefInput: payload['actor'] || 'gateway_incident_response',
      resourceKind: 'incident_bundle',
      resourceRefInput: payload['target'] || event.subjectId || operation,
      action: operation,
      result: resultFromPayload(payload),
      retentionClass: 'incident_evidence',
    }
  }
  if (operation.includes('evidence')) {
    return {
      class: 'evidence_export',
      actorKind: 'local_operator',
      actorRefInput: payload['actor'] || 'local_operator',
      resourceKind: 'evidence_export',
      resourceRefInput: payload['target'] || event.subjectId || operation,
      action: operation,
      result: resultFromPayload(payload),
      retentionClass: 'incident_evidence',
    }
  }
  return {
    class: 'security_decision',
    actorKind: sourceLooksChannel(payload['source']) ? 'connector' : 'gateway_system',
    actorRefInput: payload['actor'] || payload['source'] || 'gateway_security',
    resourceKind: 'channel_binding',
    resourceRefInput: payload['target'] || event.subjectId || operation,
    action: operation,
    result: resultFromPayload(payload),
    retentionClass: 'security_audit',
  }
}

function redactPayloadObject(value: unknown, depth: number, key = ''): unknown {
  if (depth > 8) return '<redacted:max-depth>'
  if (Array.isArray(value)) return value.slice(0, 50).map(child => redactPayloadObject(child, depth + 1, key))
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {}
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
      output[childKey] = redactPayloadObject(child, depth + 1, childKey)
    }
    return output
  }
  if (typeof value === 'string') return redactScalarText(key, value)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) return value
  return `<redacted:${typeof value}>`
}

function redactScalarText(key: string, value: string): string {
  const text = value.slice(0, 20_000)
  if (SECRET_KEY_PATTERN.test(key)) return `<redacted:secret:${hashText(text).slice(0, 12)}>`
  if (PRIVATE_TEXT_KEY_PATTERN.test(key)) return `<redacted:text:${hashText(text).slice(0, 12)}:${text.length} chars>`
  let redacted = redactSensitiveText(text)
    .replace(/(?:\/Users\/[^\s"'`),;]+|\/var\/[^\s"'`),;]+|\/tmp\/[^\s"'`),;]+|\/private\/[^\s"'`),;]+)/g, match => `<redacted:path:${hashText(match).slice(0, 12)}>`)
  redacted = replaceProviderTargetText(redacted, ({ provider, chatId, threadId }) => `${provider}:target:${hashText(chatId).slice(0, 12)}${threadId ? ':thread:' + hashText(threadId).slice(0, 8) : ''}`)
  redacted = replaceSessionIdText(redacted, raw => `<redacted:session:${hashText(raw).slice(0, 12)}>`)
  redacted = replacePrivateText(redacted, raw => `<redacted:private-text:${hashText(raw).slice(0, 12)}>`)
  redacted = replacePhoneLikeText(redacted, raw => `<redacted:phone:${hashText(raw).slice(0, 12)}>`)
  if (REF_KEY_PATTERN.test(key) && redacted === text && text.length > 3) return redactedRef(key, text)
  return redacted.slice(0, 2000)
}

function providerTargetRefInput(payload: Record<string, unknown>, fallback: string): string {
  const provider = typeof payload['provider'] === 'string' ? payload['provider'] : 'channel'
  const chatId = typeof payload['chatId'] === 'string' ? payload['chatId'] : typeof payload['chat_id'] === 'string' ? payload['chat_id'] : ''
  const threadId = typeof payload['threadId'] === 'string' ? payload['threadId'] : typeof payload['thread_id'] === 'string' ? payload['thread_id'] : ''
  if (!chatId) return fallback
  return `${provider}:${chatId}${threadId ? ':' + threadId : ''}`
}

function traceIdForEvent(event: WorkEventRecord, semantics: LedgerSemantics): string {
  const payload = event.payload || {}
  const explicit = firstString(payload['traceId'], payload['trace_id'], payload['correlationId'], payload['correlation_id'])
  if (explicit) return redactedRef('trace', explicit)
  return `trace_audit_${hashText([event.id, event.type, semantics.resourceKind, semantics.action].join(':')).slice(0, 16)}`
}

function correlationIdForEvent(event: WorkEventRecord): string | undefined {
  const payload = event.payload || {}
  const explicit = firstString(payload['correlationId'], payload['correlation_id'], payload['idempotencyKey'], payload['receiptId'], payload['runId'], payload['taskId'], payload['roadmapId'], event.subjectId)
  return explicit ? redactedRef('correlation', explicit) : undefined
}

function resultFromPayload(payload: Record<string, unknown>): 'ok' | 'denied' | 'error' {
  if (payload['error'] || payload['failure'] || payload['exception']) return 'error'
  const value = stringOr(payload['result'] || payload['status'] || payload['outcome'], 'ok').toLowerCase()
  if (/(denied|reject|blocked|unauthorized|forbidden)/.test(value)) return 'denied'
  if (/(error|failed|failure|timeout)/.test(value)) return 'error'
  return 'ok'
}

function sourceLooksChannel(value: unknown): boolean {
  return /channel|telegram|whatsapp|discord|webhook/i.test(String(value || ''))
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function normalizeIsoTime(value: string): string {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date(0).toISOString()
}

function redactedRef(kind: string, input: unknown): string {
  const raw = String(input || kind || 'unknown')
  return `${kind}:${hashText(raw).slice(0, 16)}`
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, canonicalize(child)]))
  }
  return value
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
